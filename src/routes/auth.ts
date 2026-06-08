import { Router } from "express";
import * as authController from "../controllers/authController.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

router.get("/challenge", authController.getChallenge);
router.post("/login", authController.login);
router.post("/verify", authMiddleware, authController.verify);

export default router;
