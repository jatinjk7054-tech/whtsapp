import jwt from 'jsonwebtoken'

// Metropad has NO separate authentication. Any valid accounts-session token is
// accepted and treated as a full ADMIN — there is no metropad_users row lookup,
// no email-link check, no "no Metropad account linked" refusal, and no role
// gate. The signed-in accounts session (the one every other page in the panel
// trusts) is the only gate, exactly like the rest of the panel.
export const protect = async (req, res, next) => {
  try {
    let token

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1]
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized — no token provided',
      })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const user = {
      id: decoded.id,
      name: decoded.name || 'Operator',
      email: decoded.email || '',
      role: 'ADMIN',
      is_active: true,
    }

    req.user = user
    next()
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized — invalid token',
      })
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({
        success: false,
        message: 'Not authorized — token expired',
      })
    }
    return res.status(403).json({
      success: false,
      message: 'Not authorized',
    })
  }
}

export const authorize = () => {
  return (req, res, next) => {
    next()
  }
}
