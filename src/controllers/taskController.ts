import { Request, Response } from "express";
import * as taskModel from "../models/task.js";
import { createTaskSchema, updateTaskSchema, listTasksQuerySchema } from "../utils/validation.js";
import { buildBoundingBoxFilter } from "../services/geoService.js";

export async function listTasks(req: Request, res: Response) {
  const parsed = listTasksQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid query parameters", details: parsed.error.flatten() });
  }

  const { swLat, swLng, neLat, neLng, ...rest } = parsed.data;
  const filters: taskModel.TaskFilters = {
    ...rest,
    swLat, swLng, neLat, neLng,
  };

  const tasks = await taskModel.listTasks(filters);
  return res.json(tasks);
}

export async function getTask(req: Request, res: Response) {
  const task = await taskModel.getTaskById(req.params.id);
  if (!task) {
    return res.status(404).json({ error: "task not found" });
  }
  return res.json(task);
}

export async function createTask(req: Request, res: Response) {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
  }

  const { expiresAt, ...rest } = parsed.data;
  const data: Parameters<typeof taskModel.createTask>[0] = {
    ...rest,
    ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
  };

  const task = await taskModel.createTask(data);
  return res.status(201).json(task);
}

export async function updateTask(req: Request, res: Response) {
  const parsed = updateTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid request body", details: parsed.error.flatten() });
  }

  const existing = await taskModel.getTaskById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: "task not found" });
  }

  const { expiresAt, ...rest } = parsed.data;
  const data: Parameters<typeof taskModel.updateTask>[1] = {
    ...rest,
    ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
  };

  const task = await taskModel.updateTask(req.params.id, data);
  return res.json(task);
}

export async function deleteTask(req: Request, res: Response) {
  const existing = await taskModel.getTaskById(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: "task not found" });
  }

  await taskModel.deleteTask(req.params.id);
  return res.status(204).send();
}
