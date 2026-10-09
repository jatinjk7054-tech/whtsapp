import {
  createTask,
  getAllTasks,
  getTaskById,
  getTasksByWorkerId,
  updateTask,
  deleteTask,
} from '../models/taskModel.js';

export const addTask = async (req, res) => {
  try {
    const { worker_id, title, description, deadline } = req.body;
    if (!worker_id || !title) {
      return res.status(400).json({ message: 'Worker ID and title are required' });
    }
    const task = await createTask({
      worker_id,
      title,
      description: description || '',
      deadline: deadline || null,
      status: 'pending',
      assigned_date: new Date().toISOString(),
    });
    return res.status(201).json({ message: 'Task assigned successfully', task });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTasks = async (req, res) => {
  try {
    const tasks = await getAllTasks();
    return res.json(tasks);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getTask = async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    return res.json(task);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getMyTasks = async (req, res) => {
  try {
    const tasks = await getTasksByWorkerId(req.user.id);
    return res.json(tasks);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editTask = async (req, res) => {
  try {
    const { title, description, status, deadline } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (status) updates.status = status;
    if (deadline) updates.deadline = deadline;
    const task = await updateTask(req.params.id, updates);
    return res.json({ message: 'Task updated successfully', task });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateTaskStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !['pending', 'in_progress', 'completed'].includes(status)) {
      return res.status(400).json({ message: 'Valid status is required (pending, in_progress, completed)' });
    }
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }
    if (task.worker_id !== req.user.id) {
      return res.status(403).json({ message: 'You can only update your own tasks' });
    }
    const updated = await updateTask(req.params.id, { status });
    return res.json({ message: 'Task status updated', task: updated });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeTask = async (req, res) => {
  try {
    const result = await deleteTask(req.params.id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
