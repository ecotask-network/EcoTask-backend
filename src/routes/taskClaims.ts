import { Router } from "express";
import { claimTask, releaseClaim, getTaskClaims } from "../controllers/taskClaimController.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

router.post("/:id/claim", authMiddleware, claimTask);
router.delete("/:id/claim", authMiddleware, releaseClaim);
router.get("/:id/claims", authMiddleware, getTaskClaims);

export default router;
