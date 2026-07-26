export class ProductError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code?: string
  ) {
    super(message);
    this.name = "ProductError";
  }
}

export class UnauthorizedError extends ProductError {
  constructor(message = "Unauthorized") {
    super(message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ProductError {
  constructor(message = "Forbidden") {
    super(message, 403);
    this.name = "ForbiddenError";
  }
}

export class ReceiptUncertaintyError extends ProductError {
  constructor(message:string,code:string) {
    super(message,409,code);
    this.name="ReceiptUncertaintyError";
  }
}

export class NotFoundError extends ProductError {
  constructor(message = "Not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}
