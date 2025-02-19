import { downloads, type Download, type InsertDownload } from "@shared/schema";

export interface DownloadProgress {
  fileName: string;
  fileSize: number;
  downloadedBytes: number;
  status: string;
  url: string;
  startTime: Date;
}

export interface IStorage {
  getDownload(id: number): Promise<Download | undefined>;
  createDownload(download: InsertDownload): Promise<Download>;
  updateDownloadStatus(id: number, status: string): Promise<Download | undefined>;
  updateDownloadProgress(url: string, progress: DownloadProgress): void;
  getActiveDownloads(): DownloadProgress[];
  stopAllDownloads(): void;
}

export class MemStorage implements IStorage {
  private downloads: Map<number, Download>;
  private downloadProgress: Map<string, DownloadProgress>;
  currentId: number;

  constructor() {
    this.downloads = new Map();
    this.downloadProgress = new Map();
    this.currentId = 1;
  }

  async getDownload(id: number): Promise<Download | undefined> {
    return this.downloads.get(id);
  }

  async createDownload(insertDownload: InsertDownload): Promise<Download> {
    const id = this.currentId++;
    const download: Download = {
      ...insertDownload,
      id,
      status: 'pending',
      filename: null,
      parts: 1,
      createdAt: new Date()
    };
    this.downloads.set(id, download);
    return download;
  }

  async updateDownloadStatus(id: number, status: string): Promise<Download | undefined> {
    const download = await this.getDownload(id);
    if (download) {
      const updatedDownload = { ...download, status };
      this.downloads.set(id, updatedDownload);
      return updatedDownload;
    }
    return undefined;
  }

  updateDownloadProgress(url: string, progress: DownloadProgress) {
    this.downloadProgress.set(url, progress);
  }

  getActiveDownloads(): DownloadProgress[] {
    return Array.from(this.downloadProgress.values());
  }

  stopAllDownloads(): void {
    // Update all active downloads to 'stopped' status
    for (const [url, progress] of this.downloadProgress.entries()) {
      this.downloadProgress.set(url, {
        ...progress,
        status: 'stopped'
      });
    }
  }
}

export const storage = new MemStorage();