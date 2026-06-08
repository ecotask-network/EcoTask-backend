declare namespace Express {
  interface Request {
    user?: { userId: string; wallet: string };
  }
}
