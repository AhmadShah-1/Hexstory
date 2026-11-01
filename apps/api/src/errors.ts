/** An error whose message is safe to show to the user. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad-request') => new HttpError(400, code, message);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Please sign in first.');
export const forbidden = (message = 'You are not allowed to do that.', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (what = 'That') => new HttpError(404, 'not-found', `${what} was not found.`);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooMany = (message: string) => new HttpError(429, 'rate-limited', message);
