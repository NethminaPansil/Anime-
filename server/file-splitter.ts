import { createReadStream, createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import path from 'path';
import { log } from './vite';

const CHUNK_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5GB chunks to stay safely under 2GB

export async function splitFile(filePath: string): Promise<string[]> {
  const splitDir = path.join(process.cwd(), 'splits');
  await mkdir(splitDir, { recursive: true });

  const fileName = path.basename(filePath);
  const partPaths: string[] = [];

  return new Promise((resolve, reject) => {
    const readStream = createReadStream(filePath);
    let partNumber = 1;
    let currentChunkSize = 0;
    let currentWriter = createWriteStream(path.join(splitDir, `${fileName}.part${partNumber}`));
    partPaths.push(path.join(splitDir, `${fileName}.part${partNumber}`));

    readStream.on('data', (chunk: Buffer) => {
      currentChunkSize += chunk.length;

      if (currentChunkSize > CHUNK_SIZE) {
        currentWriter.end();
        partNumber++;
        currentChunkSize = chunk.length;
        currentWriter = createWriteStream(path.join(splitDir, `${fileName}.part${partNumber}`));
        partPaths.push(path.join(splitDir, `${fileName}.part${partNumber}`));
      }

      currentWriter.write(chunk);
    });

    readStream.on('end', () => {
      currentWriter.end();
      log(`File split into ${partNumber} parts`, 'splitter');
      resolve(partPaths);
    });

    readStream.on('error', (error: Error) => {
      log(`Error splitting file: ${error}`, 'splitter');
      reject(error);
    });
  });
}