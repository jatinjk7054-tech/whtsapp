import * as authService from '../services/authService.js'

export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body
    const result = await authService.login(email, password)
    res.json({ success: true, data: result })
  } catch (err) {
    next(err)
  }
}

export const getMe = async (req, res, next) => {
  try {
    const user = await authService.getMe(req.user.id)
    res.json({ success: true, data: user })
  } catch (err) {
    next(err)
  }
}
