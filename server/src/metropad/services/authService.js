import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import * as UserModel from '../models/user.model.js'
import { AppError } from '../middleware/errorHandler.js'

export const login = async (email, password) => {
  const user = await UserModel.findUserByEmail(email)

  if (!user) {
    throw new AppError('Invalid email or password', 401)
  }

  if (!user.is_active) {
    throw new AppError('Account is deactivated. Contact administrator.', 403)
  }

  const isMatch = await bcrypt.compare(password, user.password_hash)

  if (!isMatch) {
    throw new AppError('Invalid email or password', 401)
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  )

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  }
}

export const getMe = async (userId) => {
  const user = await UserModel.findUserById(userId)

  if (!user) {
    throw new AppError('User not found', 404)
  }

  return user
}
