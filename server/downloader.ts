import axios from 'axios';
import { createWriteStream, existsSync, unlink } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { log } from './vite';
import { storage } from './storage';
import type { DownloadProgress } from './storage';

const DOWNLOAD_DIR = path.join(process.cwd(), 'downloads');

interface DownloadResult {
  filePath: string;
  fileName: string;
  fileSize: number;
}

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

export async function handleDownload(url: string): Promise<DownloadResult> {
  try {
    await mkdir(DOWNLOAD_DIR, { recursive: true });

    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const contentDisposition = response.headers['content-disposition'];
    const contentLength = parseInt(response.headers['content-length'] || '0', 10);

    let fileName = path.basename(url);
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match) fileName = match[1];
    }

    const filePath = path.join(DOWNLOAD_DIR, fileName);
    const writer = createWriteStream(filePath);

    let downloadedBytes = 0;
    const startTime = new Date();

    // Initialize progress in storage
    const progress: DownloadProgress = {
      fileName,
      fileSize: contentLength,
      downloadedBytes: 0,
      status: 'downloading',
      url,
      startTime
    };
    storage.updateDownloadProgress(url, progress);

    response.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;

      // Get latest progress to check if download was stopped
      const currentProgress = storage.getActiveDownloads().find(d => d.url === url);
      if (currentProgress?.status === 'stopped') {
        response.data.destroy(); // This will cause the pipeline to fail and trigger cleanup
        throw new Error('Download stopped by user');
      }

      storage.updateDownloadProgress(url, {
        ...progress,
        downloadedBytes,
        status: 'downloading'
      });
    });

    try {
      await pipeline(response.data, writer);
    } catch (error: any) {
      // Clean up the partially downloaded file if the download was stopped
      if (existsSync(filePath)) {
        await unlink(filePath);
      }
      throw error;
    }

    // Update final status
    storage.updateDownloadProgress(url, {
      ...progress,
      downloadedBytes: contentLength,
      status: 'completed'
    });

    log(`Download completed: ${fileName}`, 'downloader');

    return {
      filePath,
      fileName,
      fileSize: contentLength || 0
    };
  } catch (error: any) {
    log(`Download failed: ${error.message}`, 'downloader');
    throw new Error(`Failed to download file: ${error.message}`);
  }
}