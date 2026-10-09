import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signToken(staff) {
  return jwt.sign(
    { sub: staff.id, email: staff.email, role: staff.role, name: staff.name },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiresIn }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, config.auth.jwtSecret);
}