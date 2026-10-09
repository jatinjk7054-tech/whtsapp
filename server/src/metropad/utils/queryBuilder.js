export function buildPagination({ page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(100, Math.max(1, Number(limit) || 20))
  const offset = (p - 1) * l
  return { offset, limit: l, page: p }
}

export function buildWhereClause(filters = []) {
  const conditions = []
  const params = []
  let paramIndex = 1

  for (const { field, operator, value } of filters) {
    const op = operator.toUpperCase()

    switch (op) {
      case 'IS NULL':
        conditions.push(`${field} IS NULL`)
        break
      case 'IS NOT NULL':
        conditions.push(`${field} IS NOT NULL`)
        break
      case 'IN': {
        if (!Array.isArray(value) || value.length === 0) break
        const placeholders = value.map((v) => {
          const ph = `$${paramIndex}`
          paramIndex++
          return ph
        })
        conditions.push(`${field} IN (${placeholders.join(', ')})`)
        params.push(...value)
        break
      }
      case 'ILIKE':
        conditions.push(`${field} ILIKE $${paramIndex}`)
        params.push(`%${value}%`)
        paramIndex++
        break
      case '=':
      case '!=':
      case '>=':
      case '<=':
      case '>':
      case '<':
        conditions.push(`${field} ${op} $${paramIndex}`)
        params.push(value)
        paramIndex++
        break
      default:
        break
    }
  }

  if (conditions.length === 0) {
    return { whereClause: '', params: [] }
  }

  return {
    whereClause: `WHERE ${conditions.join(' AND ')}`,
    params,
  }
}

export function buildSortClause(sortBy, sortDir = 'ASC') {
  if (!sortBy) return 'ORDER BY created_at DESC'
  const direction = sortDir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
  const allowedSortColumns = [
    'created_at', 'updated_at', 'name', 'email', 'role',
    'status', 'id', 'code', 'machine_id', 'current_stock',
    'capacity', 'priority', 'reported_date', 'resolved_date',
    'refill_date', 'report_date', 'action', 'entity',
  ]
  const column = allowedSortColumns.includes(sortBy) ? sortBy : 'created_at'
  return `ORDER BY ${column} ${direction}`
}

export function buildPaginationMeta(total, page, limit) {
  return {
    page,
    limit,
    total: Number(total),
    totalPages: Math.ceil(Number(total) / limit),
  }
}
