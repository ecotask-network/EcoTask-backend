import request from "supertest";
import app from "../../src/app";
import jwt from "jsonwebtoken";

jest.mock("../../src/models/task", () => ({
  listTasks: jest.fn(),
  getTaskById: jest.fn(),
  createTask: jest.fn(),
  updateTask: jest.fn(),
  deleteTask: jest.fn(),
}));

jest.mock("../../src/utils/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn() },
  },
}));

import * as taskModel from "../../src/models/task";
import prisma from "../../src/utils/prisma";

const mockTask = taskModel as unknown as {
  listTasks: jest.Mock;
  getTaskById: jest.Mock;
  createTask: jest.Mock;
  updateTask: jest.Mock;
  deleteTask: jest.Mock;
};

function adminToken(): string {
  return jwt.sign({ userId: "admin-id", wallet: "GADMIN..." }, "dev-secret-change-in-production");
}

function userToken(): string {
  return jwt.sign({ userId: "user-id", wallet: "GUSER..." }, "dev-secret-change-in-production");
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: "admin-id", role: "admin" });
});

describe("Task Routes", () => {
  describe("GET /tasks", () => {
    it("returns a list of tasks", async () => {
      mockTask.listTasks.mockResolvedValue([{ id: "1", title: "Test Task" }]);
      const res = await request(app).get("/tasks");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "1", title: "Test Task" }]);
    });

    it("filters by type query parameter", async () => {
      mockTask.listTasks.mockResolvedValue([]);
      const res = await request(app).get("/tasks").query({ type: "cleanup" });
      expect(res.status).toBe(200);
      expect(mockTask.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cleanup" }),
      );
    });

    it("filters by status", async () => {
      mockTask.listTasks.mockResolvedValue([]);
      const res = await request(app).get("/tasks").query({ status: "ACTIVE" });
      expect(res.status).toBe(200);
      expect(mockTask.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ACTIVE" }),
      );
    });

    it("filters by reward range", async () => {
      mockTask.listTasks.mockResolvedValue([]);
      const res = await request(app).get("/tasks").query({ minReward: "30", maxReward: "60" });
      expect(res.status).toBe(200);
      expect(mockTask.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ minReward: 30, maxReward: 60 }),
      );
    });

    it("filters by bounding box", async () => {
      mockTask.listTasks.mockResolvedValue([]);
      const res = await request(app)
        .get("/tasks")
        .query({ swLat: "40.7", swLng: "-74.01", neLat: "40.75", neLng: "-73.98" });
      expect(res.status).toBe(200);
      expect(mockTask.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ swLat: 40.7, swLng: -74.01, neLat: 40.75, neLng: -73.98 }),
      );
    });

    it("returns 400 for invalid query params", async () => {
      const res = await request(app).get("/tasks").query({ minReward: "not-a-number" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /tasks/:id", () => {
    it("returns a task by id", async () => {
      mockTask.getTaskById.mockResolvedValue({ id: "task-1", title: "Found Task" });
      const res = await request(app).get("/tasks/task-1");
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Found Task");
    });

    it("returns 404 for non-existent task", async () => {
      mockTask.getTaskById.mockResolvedValue(null);
      const res = await request(app).get("/tasks/non-existent-id");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /tasks", () => {
    it("requires authentication", async () => {
      const res = await request(app).post("/tasks").send({ title: "Test" });
      expect(res.status).toBe(401);
    });

    it("forbids non-admin users", async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: "user-id", role: "user" });
      const res = await request(app)
        .post("/tasks")
        .set("Authorization", `Bearer ${userToken()}`)
        .send({ title: "Test", type: "cleanup", rewardAmount: 10, lat: 0, lng: 0 });
      expect(res.status).toBe(403);
    });

    it("returns 400 for missing required fields with auth", async () => {
      const res = await request(app)
        .post("/tasks")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it("creates a task with valid data", async () => {
      mockTask.createTask.mockResolvedValue({ id: "new-task", title: "New Task", type: "cleanup", rewardAmount: 50, lat: 40.71, lng: -74.0 });
      const res = await request(app)
        .post("/tasks")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ title: "New Task", type: "cleanup", rewardAmount: 50, lat: 40.71, lng: -74.0 });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe("new-task");
    });
  });

  describe("PUT /tasks/:id", () => {
    it("requires authentication", async () => {
      const res = await request(app).put("/tasks/some-id").send({ title: "Updated" });
      expect(res.status).toBe(401);
    });

    it("forbids non-admin users", async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: "user-id", role: "user" });
      const res = await request(app)
        .put("/tasks/some-id")
        .set("Authorization", `Bearer ${userToken()}`)
        .send({ title: "Updated" });
      expect(res.status).toBe(403);
    });

    it("returns 404 for non-existent task", async () => {
      mockTask.getTaskById.mockResolvedValue(null);
      const res = await request(app)
        .put("/tasks/non-existent-id")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ title: "Updated" });
      expect(res.status).toBe(404);
    });

    it("updates a task with valid data", async () => {
      mockTask.getTaskById.mockResolvedValue({ id: "task-1", title: "Old Title" });
      mockTask.updateTask.mockResolvedValue({ id: "task-1", title: "Updated Title" });
      const res = await request(app)
        .put("/tasks/task-1")
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({ title: "Updated Title" });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Updated Title");
    });
  });

  describe("DELETE /tasks/:id", () => {
    it("requires authentication", async () => {
      const res = await request(app).delete("/tasks/some-id");
      expect(res.status).toBe(401);
    });

    it("forbids non-admin users", async () => {
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: "user-id", role: "user" });
      const res = await request(app)
        .delete("/tasks/some-id")
        .set("Authorization", `Bearer ${userToken()}`);
      expect(res.status).toBe(403);
    });

    it("returns 404 for non-existent task", async () => {
      mockTask.getTaskById.mockResolvedValue(null);
      const res = await request(app)
        .delete("/tasks/non-existent-id")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(res.status).toBe(404);
    });

    it("deletes an existing task", async () => {
      mockTask.getTaskById.mockResolvedValue({ id: "task-1", title: "To Delete" });
      mockTask.deleteTask.mockResolvedValue({ id: "task-1" });
      const res = await request(app)
        .delete("/tasks/task-1")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(res.status).toBe(204);
    });
  });
});
