import bcrypt from 'bcryptjs'
import * as UserModel from '../models/user.model.js'
import { AppError } from '../middleware/errorHandler.js'
import * as AuditService from './audit.service.js'

const VALID_ROLES = ['ADMIN', 'OPERATOR', 'VIEWER']
const SALT_ROUNDS = 10

const safeUser = ({ id, name, email, role, is_active, created_at, updated_at }) => ({
  id, name, email, role, is_active, created_at, updated_at,
})

export const getAllUsers = async (filters = {}) => {
  return UserModel.getAllUsers(filters)
}

export const getUserById = async (id) => {
  const user = await UserModel.findUserById(id)
  if (!user) {
    throw new AppError('User not found', 404)
  }
  return user
}

export const createUser = async (data, user) => {
  const { name, email, role = 'VIEWER', password } = data

  if (!name || !name.trim()) {
    throw new AppError('Name is required', 400)
  }
  if (!email || !email.trim()) {
    throw new AppError('Email is required', 400)
  }
  if (password && password.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400)
  }
  if (!VALID_ROLES.includes(role)) {
    throw new AppError(`Invalid role: ${role}. Must be one of ${VALID_ROLES.join(', ')}`, 400)
  }

  const existing = await UserModel.findUserByEmail(email.trim().toLowerCase())
  if (existing) {
    throw new AppError('A user with this email already exists', 409)
  }

  const passwordHash = password
    ? await bcrypt.hash(password, SALT_ROUNDS)
    : await bcrypt.hash('View@1234', SALT_ROUNDS)

  const created = await UserModel.createUser({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash,
    role,
  })
  await AuditService.logAction(user, 'CREATE', 'USER', created.id, null, created)
  return created
}

export const updateUser = async (id, data, user) => {
  const existing = await UserModel.findUserById(id)
  if (!existing) {
    throw new AppError('User not found', 404)
  }

  if (data.email !== undefined) {
    const normalized = data.email.trim().toLowerCase()
    const emailOwner = await UserModel.findUserByEmail(normalized)
    if (emailOwner && emailOwner.id !== id) {
      throw new AppError('A user with this email already exists', 409)
    }
    data.email = normalized
  }
  if (data.role !== undefined && !VALID_ROLES.includes(data.role)) {
    throw new AppError(`Invalid role: ${data.role}. Must be one of ${VALID_ROLES.join(', ')}`, 400)
  }

  const updated = await UserModel.updateUser(id, {
    name: data.name !== undefined ? data.name.trim() : undefined,
    email: data.email,
    role: data.role,
    isActive: data.isActive,
  })
  await AuditService.logAction(user, 'UPDATE', 'USER', id, existing, safeUser(updated))
  return updated
}

export const resetUserPassword = async (id, data, user) => {
  const existing = await UserModel.findUserById(id)
  if (!existing) {
    throw new AppError('User not found', 404)
  }

  const newPassword = data.password
  if (!newPassword || newPassword.length < 8) {
    throw new AppError('Password must be at least 8 characters', 400)
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS)
  const updated = await UserModel.updateUserPassword(id, passwordHash)
  await AuditService.logAction(user, 'RESET_PASSWORD', 'USER', id, null, { reset: true })
  return updated
}

export const deleteUser = async (id, user) => {
  if (id === user.id) {
    throw new AppError('You cannot delete your own account', 400)
  }

  const existing = await UserModel.findUserById(id)
  if (!existing) {
    throw new AppError('User not found', 404)
  }

  await UserModel.removeUser(id)
  await AuditService.logAction(user, 'DELETE', 'USER', id, existing, null)
  return existing
}