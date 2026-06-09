import { Router } from "express";
import * as taskController from "../controllers/taskController.js";
import { authMiddleware } from "../middleware/auth.js";
import { adminMiddleware } from "../middleware/admin.js";

const router = Router();

router.get("/", taskController.listTasks);
router.get("/:id", taskController.getTask);
router.post("/", authMiddleware, adminMiddleware, taskController.createTask);
router.put("/:id", authMiddleware, adminMiddleware, taskController.updateTask);
router.delete("/:id", authMiddleware, adminMiddleware, taskController.deleteTask);

export default router;
