export class SubstackAPIError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public endpoint: string,
  ) {
    super(`Substack API error (${statusCode}) at ${endpoint}: ${message}`);
    this.name = "SubstackAPIError";
  }
}

export class AuthenticationError extends SubstackAPIError {
  constructor(endpoint: string) {
    super(401, "Session token is invalid or expired. Get a fresh token from browser DevTools > Application > Cookies > connect.sid (or substack.sid on substack.com)", endpoint);
    this.name = "AuthenticationError";
  }
}
