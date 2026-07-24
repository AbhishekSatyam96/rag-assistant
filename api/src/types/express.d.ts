import "express";

// Declaration merging: teach TypeScript that our middleware may attach a `user`
// to the request object, so `req.user` is typed everywhere downstream instead of
// being `any`. This file has no runtime output — it's types only.
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}
