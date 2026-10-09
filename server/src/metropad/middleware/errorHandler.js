export class AppError extends Error {
  constructor(message, statusCode) {
    super(message)
    this.statusCode = statusCode
    this.isOperational = true
    Error.captureStackTrace(this, this.constructor)
  }
}

export class ValidationError extends AppError {
  constructor(message, errors = []) {
    super(message, 400)
    this.errors = errors
  }
}

export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500
  let message = err.message || 'Internal server error'
  let errors = err.errors || undefined

  console.error(`[ERROR] ${req.method} ${req.originalUrl} —`, err.stack || err.message)

  if (err.isOperational) {
    return res.status(statusCode).json({
      success: false,
      message,
      ...(errors && { errors }),
    })
  }

  if (err.name === 'JsonWebTokenError') {
    statusCode = 403
    message = 'Invalid token'
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 403
    message = 'Token expired'
  } else if (err.name === 'ValidationError') {
    statusCode = 400
    message = err.message
  } else if (err.code === '23505') {
    statusCode = 409
    message = 'Duplicate entry — record already exists'
  } else if (err.code === '23503') {
    statusCode = 400
    message = 'Referenced record not found'
  } else if (err.code === '23502') {
    statusCode = 400
    message = 'Missing required field'
  } else if (err.code === '22P02') {
    statusCode = 400
    message = 'Invalid data format'
  } else {
    statusCode = 500
    message = 'Internal server error'
  }

  return res.status(statusCode).json({
    success: false,
    message,
  })
}
