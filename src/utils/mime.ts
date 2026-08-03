import path from 'node:path';

export function mimeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}
