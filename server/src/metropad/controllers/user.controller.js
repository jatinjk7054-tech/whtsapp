import * as userService from '../services/user.service.js'

export const getAll = async (req, res, next) => {
  try {
    const { search, page, limit } = req.query
    const result = await userService.getAllUsers({ search, page, limit })
    res.json({ success: true, ...result })
  } catch (err) {
    next(err)
  }
}

export const getById = async (req, res, next) => {
  try {
    const result = await userService.getUserById(req.params.id)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const create = async (req, res, next) => {
  try {
    const result = await userService.createUser(req.body, req.user)
    res.status(201).json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const update = async (req, res, next) => {
  try {
    const result = await userService.updateUser(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const resetPassword = async (req, res, next) => {
  try {
    const result = await userService.resetUserPassword(req.params.id, req.body, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

const remove = async (req, res, next) => {
  try {
    const result = await userService.deleteUser(req.params.id, req.user)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export { remove as delete }