export function sanitizeError(error, userMessage = 'An error occurred') {
  console.error('Server error:', error?.message || error);
  return { message: userMessage };
}

export function handleControllerError(res, error, userMessage = 'An error occurred') {
  console.error('Controller error:', error?.message || error);
  return res.status(500).json({ message: userMessage });
}
