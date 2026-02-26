export function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
  console.log(`[${ts}] ${message}`);
}
