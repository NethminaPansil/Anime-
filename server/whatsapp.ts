import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { promises as fs } from 'fs';
import { join } from 'path';
import { log } from './vite';
import { handleDownload } from './downloader';
import { splitFile } from './file-splitter';
import { unlink, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { default as P } from 'pino';
import { storage } from './storage';

const AUTH_FOLDER = './auth';
const DOWNLOAD_DIR = join(process.cwd(), 'downloads');
const SPLIT_DIR = join(process.cwd(), 'splits');
let sock: any = null;

// Admin system
const SUDO_USER = '94711797456@s.whatsapp.net';
const admins = new Set([SUDO_USER]);

// Helper function to check if user is admin
function isAdmin(jid: string): boolean {
  return admins.has(jid);
}

// Helper function to clean all files in a directory
async function cleanDirectory(dir: string): Promise<number> {
  try {
    if (!existsSync(dir)) return 0;

    const files = await readdir(dir);
    let count = 0;

    for (const file of files) {
      await unlink(join(dir, file));
      count++;
    }

    return count;
  } catch (error) {
    log(`Error cleaning directory ${dir}: ${error}`, 'whatsapp');
    return 0;
  }
}

// Helper function to list files in downloads directory
async function listDownloadedFiles(): Promise<string[]> {
  try {
    if (!existsSync(DOWNLOAD_DIR)) {
      await mkdir(DOWNLOAD_DIR, { recursive: true });
      return [];
    }
    return await readdir(DOWNLOAD_DIR);
  } catch (error) {
    log(`Error listing files: ${error}`, 'whatsapp');
    return [];
  }
}

async function connectToWhatsApp() {
  try {
    await mkdir(AUTH_FOLDER, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const logger = P({ level: 'silent' });

    sock = makeWASocket({
      printQRInTerminal: true,
      auth: state,
      logger,
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        log(`Connection closed due to ${lastDisconnect?.error?.message}. ${shouldReconnect ? 'Reconnecting...' : 'Not reconnecting.'}`, 'whatsapp');

        if (shouldReconnect) {
          setTimeout(() => {
            log('Attempting to reconnect...', 'whatsapp');
            connectToWhatsApp();
          }, 5000);
        }
      }

      if (connection === 'open') {
        log('WhatsApp connection established!', 'whatsapp');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }: any) => {
      for (const message of messages) {
        if (!message.message) continue;

        const textMessage = message.message.conversation ||
          (message.message.extendedTextMessage && message.message.extendedTextMessage.text);

        const jid = message.key.remoteJid!;
        const sender = message.key.participant || message.key.remoteJid;

        // Handle .add command (admin only)
        if (textMessage?.startsWith('.add ') && isAdmin(sender)) {
          const numberToAdd = textMessage.slice(5).trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          if (admins.has(numberToAdd)) {
            await sock.sendMessage(jid, { text: '❌ User is already an admin' }, { quoted: message });
          } else {
            admins.add(numberToAdd);
            await sock.sendMessage(jid, { text: '✅ Admin added successfully' }, { quoted: message });
          }
          continue;
        }

        // Handle .remove command (admin only)
        if (textMessage?.startsWith('.remove ') && isAdmin(sender)) {
          const numberToRemove = textMessage.slice(8).trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net';
          if (numberToRemove === SUDO_USER) {
            await sock.sendMessage(jid, { text: '❌ Cannot remove sudo user' }, { quoted: message });
          } else if (!admins.has(numberToRemove)) {
            await sock.sendMessage(jid, { text: '❌ User is not an admin' }, { quoted: message });
          } else {
            admins.delete(numberToRemove);
            await sock.sendMessage(jid, { text: '✅ Admin removed successfully' }, { quoted: message });
          }
          continue;
        }

        // Handle .stat command
        if (textMessage === '.stat') {
          try {
            const activeDownloads = storage.getActiveDownloads();

            let statusText = '';

            // Show active downloads
            if (activeDownloads.length > 0) {
              statusText += '*📊 Active Downloads*\n\n';
              statusText += activeDownloads.map(download => {
                const progress = ((download.downloadedBytes / download.fileSize) * 100).toFixed(1);
                const size = formatBytes(download.fileSize);
                return `📄 *${download.fileName}*\n` +
                       `├ Size: ${size}\n` +
                       `├ Progress: ${progress}%\n` +
                       `└ Status: ${download.status}`;
              }).join('\n\n');
            } else {
              statusText += '📂 No active downloads';
            }

            await sock.sendMessage(jid, { text: statusText }, { quoted: message });
            continue;
          } catch (error: any) {
            log(`Error in stat command: ${error}`, 'whatsapp');
            await sock.sendMessage(jid, {
              text: `❌ *Error:* ${error.message}`
            }, { quoted: message });
            continue;
          }
        }

        // Handle .del command (admin only)
        if (textMessage === '.del' && isAdmin(sender)) {
          try {
            const downloadCount = await cleanDirectory(DOWNLOAD_DIR);
            const splitCount = await cleanDirectory(SPLIT_DIR);

            await sock.sendMessage(jid, {
              text: `✨ *Cleanup Complete!*\n\n📁 Removed ${downloadCount} files from downloads\n📂 Removed ${splitCount} split files`
            }, { quoted: message });
            continue;
          } catch (error: any) {
            log(`Error in cleanup: ${error}`, 'whatsapp');
            await sock.sendMessage(jid, {
              text: `❌ *Error during cleanup:* ${error.message}`
            }, { quoted: message });
            continue;
          }
        }

        // Handle .mdl command for multiple downloads
        if (textMessage?.startsWith('.mdl ')) {
          // Improved URL parsing
          const urls: string[] = textMessage
            .slice(4)  // Remove the .mdl prefix
            .split(/[\n\r\s]+/)  // Split by newlines, carriage returns, and spaces
            .map((line: string) => line.trim())  // Trim whitespace
            .filter((line: string) => {
              try {
                // Validate URL format
                new URL(line);
                return line.startsWith('http');
              } catch {
                return false;
              }
            });

          if (urls.length === 0) {
            await sock.sendMessage(jid, { 
              text: '❌ No valid URLs found. Please provide at least one valid URL.\n\nExample usage:\n.mdl https://example.com/file1\nhttps://example.com/file2' 
            }, { quoted: message });
            continue;
          }

          const statusMessage = await sock.sendMessage(jid, { 
            text: `📥 Starting download of ${urls.length} files...\n\n${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}` 
          }, { quoted: message });

          let successCount = 0;
          let failedUrls: { url: string; error: string }[] = [];

          const downloadPromises = urls.map(async (url, i) => {
            try {
              const { filePath, fileName, fileSize } = await handleDownload(url);

              if (fileSize > 2 * 1024 * 1024 * 1024) { // 2GB
                await sock.sendMessage(jid, { 
                  text: `⚒️ Splitting large file: ${fileName}`
                }, { quoted: message });

                const parts = await splitFile(filePath);
                const totalParts = parts.length;

                for (let j = 0; j < parts.length; j++) {
                  await sock.sendMessage(jid, {
                    document: await fs.readFile(parts[j]),
                    fileName: `${fileName}.part${j + 1}`,
                    caption: `🖇️ *${fileName}*\n_(Part ${j + 1} of ${totalParts})_`,
                    mimetype: 'application/octet-stream'
                  }, { quoted: message });

                  await unlink(parts[j]);
                }
              } else {
                await sock.sendMessage(jid, {
                  document: await fs.readFile(filePath),
                  fileName,
                  caption: `🖇️ *${fileName}*`,
                  mimetype: 'application/octet-stream'
                }, { quoted: message });
              }

              if (existsSync(filePath)) {
                await unlink(filePath);
                log(`Cleaned up file: ${filePath}`, 'whatsapp');
              }

              successCount++;
              await sock.sendMessage(jid, { 
                text: `✅ Successfully downloaded (${i + 1}/${urls.length}): ${fileName}`
              }, { quoted: message });

              return { success: true, url };
            } catch (error: any) {
              log(`Error downloading ${url}: ${error.message}`, 'whatsapp');
              failedUrls.push({ url, error: error.message });
              await sock.sendMessage(jid, { 
                text: `❌ Failed to download (${i + 1}/${urls.length}): ${url}\nError: ${error.message}`
              }, { quoted: message });
              return { success: false, url, error: error.message };
            }
          });

          await Promise.all(downloadPromises);

          // Send summary message
          const summaryText = `✨ *Download Summary*\n\n` +
            `✅ Successfully downloaded: ${successCount}/${urls.length}\n\n` +
            (failedUrls.length > 0 ? `❌ Failed downloads:\n${failedUrls.map(f => `${f.url}\nError: ${f.error}`).join('\n\n')}` : '');

          await sock.sendMessage(jid, { 
            text: summaryText
          }, { quoted: message });
          continue;
        }

        // Handle single file download (.dl command)
        if (textMessage?.startsWith('.dl ')) {
          const url = textMessage.slice(4).trim();

          try {
            await sock.sendMessage(jid, { react: { text: "⬇️", key: message.key } });
            const { filePath, fileName, fileSize } = await handleDownload(url);

            if (fileSize > 2 * 1024 * 1024 * 1024) { // 2GB
              await sock.sendMessage(jid, { react: { text: "⚒️", key: message.key } });
              const parts = await splitFile(filePath);
              const totalParts = parts.length;

              await sock.sendMessage(jid, { react: { text: "⬆️", key: message.key } });

              for (let i = 0; i < parts.length; i++) {
                await sock.sendMessage(jid, {
                  document: await fs.readFile(parts[i]),
                  fileName: `${fileName}.part${i + 1}`,
                  caption: `🖇️ *${fileName}*\n_(Part ${i + 1} of ${totalParts})_`,
                  mimetype: 'application/octet-stream'
                }, { quoted: message });

                await unlink(parts[i]);
              }
            } else {
              await sock.sendMessage(jid, { react: { text: "⬆️", key: message.key } });

              await sock.sendMessage(jid, {
                document: await fs.readFile(filePath),
                fileName,
                caption: `🖇️ *${fileName}*`,
                mimetype: 'application/octet-stream'
              }, { quoted: message });
            }

            if (existsSync(filePath)) {
              await unlink(filePath);
              log(`Cleaned up file: ${filePath}`, 'whatsapp');
            }

            await sock.sendMessage(jid, { react: { text: "✅", key: message.key } });

          } catch (error: any) {
            log(`Error processing download: ${error}`, 'whatsapp');
            await sock.sendMessage(jid, { react: { text: "💔", key: message.key } });
            await sock.sendMessage(jid, {
              text: `❌ *Error:* ${error.message}`
            }, { quoted: message });
          }
        }
      }
    });
  } catch (error: any) {
    log(`Error in WhatsApp connection: ${error.message}`, 'whatsapp');
    setTimeout(() => {
      log('Attempting to reconnect after error...', 'whatsapp');
      connectToWhatsApp();
    }, 5000);
  }
}

// Helper function for formatting bytes
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export async function initWhatsapp() {
  try {
    await connectToWhatsApp();
    log('WhatsApp client initialized successfully', 'whatsapp');
  } catch (error: any) {
    log(`Failed to initialize WhatsApp client: ${error.message}`, 'whatsapp');
    throw error;
  }
}