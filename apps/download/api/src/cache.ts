import Redis from 'ioredis';

import type { ReadyState } from './util/cook';
import { DownloadState } from './util/download';

export interface TranscribeState {
  message?: string;
  progress?: number;
}

export const client = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379,
  keyPrefix: 'craig:',
  lazyConnect: true
});

export async function getReadyState(recordingId: string) {
  const data = await client.get(`ready:${recordingId}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function setReadyState(recordingId: string, data: ReadyState) {
  return await client.set(`ready:${recordingId}`, JSON.stringify(data), 'EX', 60 * 5);
}

export async function clearReadyState(recordingId: string) {
  return await client.del(`ready:${recordingId}`);
}

export async function getDownload(recordingId: string) {
  const data = await client.get(`download:${recordingId}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function setDownload(recordingId: string, data: DownloadState) {
  return await client.set(`download:${recordingId}`, JSON.stringify(data), 'EX', 60 * 60 * 24);
}

export async function clearDownload(recordingId: string) {
  return await client.del(`download:${recordingId}`);
}

export async function getTranscribeState(recordingId: string): Promise<TranscribeState | null> {
  const data = await client.get(`transcribe:${recordingId}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function setTranscribeState(recordingId: string, data: TranscribeState) {
  return await client.set(`transcribe:${recordingId}`, JSON.stringify(data), 'EX', 60 * 60);
}

export async function clearTranscribeState(recordingId: string) {
  return await client.del(`transcribe:${recordingId}`);
}

export async function getTranscribeDownload(recordingId: string) {
  const data = await client.get(`transcribe-dl:${recordingId}`);
  if (!data) return null;
  return JSON.parse(data) as { file: string; format: string };
}

export async function setTranscribeDownload(recordingId: string, data: { file: string; format: string }) {
  return await client.set(`transcribe-dl:${recordingId}`, JSON.stringify(data), 'EX', 60 * 60 * 24);
}

export async function clearTranscribeDownload(recordingId: string) {
  return await client.del(`transcribe-dl:${recordingId}`);
}
