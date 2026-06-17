export default {
  info: (msg: string, meta?: any) => console.log(JSON.stringify({ level: "info", msg, meta, timestamp: new Date().toISOString() })),
  error: (meta: any) => console.error(JSON.stringify({ level: "error", ...meta, timestamp: new Date().toISOString() })),
  warn: (msg: string, meta?: any) => console.warn(JSON.stringify({ level: "warn", msg, meta, timestamp: new Date().toISOString() })),
};
