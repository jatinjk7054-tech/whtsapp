import { Router } from 'express';
import { HttpError } from '../lib/HttpError.js';
import { idParam, createTaskBody, listTasksQuery, updateTaskBody } from './task.schema.js';
import * as repo from './task.repository.js';

export const taskRouter = Router();

taskRouter.get('/', async (req, res, next) => {
  try {
    const filters = listTasksQuery.parse(req.query);
    res.json(await repo.listTasks(filters));
  } catch (err) {
    next(err);
  }
});

taskRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    const task = await repo.getTask(id);
    if (!task) throw new HttpError(404, `Task ${id} not found`);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

taskRouter.post('/', async (req, res, next) => {
  try {
    const body = createTaskBody.parse(req.body);
    const task = await repo.createTask(body);
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

taskRouter.patch('/:id', async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    const body = updateTaskBody.parse(req.body);
    const task = await repo.updateTask(id, body);
    if (!task) throw new HttpError(404, `Task ${id} not found`);
    res.json(task);
  } catch (err) {
    next(err);
  }
});

taskRouter.delete('/:id', async (req, res, next) => {
  try {
    const { id } = idParam.parse(req.params);
    const deleted = await repo.deleteTask(id);
    if (!deleted) throw new HttpError(404, `Task ${id} not found`);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});