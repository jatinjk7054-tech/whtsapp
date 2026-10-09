// MetroPad Care machine specification.
// Every station has exactly one machine. Each machine has 2 slots of 25 pads.
export const SLOTS_PER_MACHINE = 2
export const SLOT_CAPACITY = 25
export const MACHINE_CAPACITY = SLOTS_PER_MACHINE * SLOT_CAPACITY

// Attaches derived slot information to a machine row.
export const withMachineSpec = (machine) => {
  if (!machine) return machine
  const capacity = Number(machine.capacity) || MACHINE_CAPACITY
  const stock = Math.max(0, Number(machine.current_stock) || 0)
  const slots = Array.from({ length: SLOTS_PER_MACHINE }, (_, i) => {
    const slotCapacity = i === SLOTS_PER_MACHINE - 1
      ? capacity - SLOT_CAPACITY * (SLOTS_PER_MACHINE - 1)
      : SLOT_CAPACITY
    const filled = Math.max(0, Math.min(slotCapacity, stock - i * SLOT_CAPACITY))
    return { slot: i + 1, capacity: slotCapacity, stock: filled }
  })
  return {
    ...machine,
    slot_count: SLOTS_PER_MACHINE,
    slot_capacity: SLOT_CAPACITY,
    slots,
  }
}
