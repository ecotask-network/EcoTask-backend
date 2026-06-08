import { Router } from "express";
import * as userController from "../controllers/userController.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

router.get("/:id", userController.getUser);
router.put("/:id", authMiddleware, userController.updateUserProfile);
router.get("/:id/impact", authMiddleware, userController.getImpact);

export default router;
