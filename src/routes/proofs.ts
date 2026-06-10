import { Router } from "express";
import * as proofController from "../controllers/proofController.js";
import { authMiddleware } from "../middleware/auth.js";
import { upload } from "../middleware/upload.js";

const router = Router();

router.post("/", authMiddleware, upload.array("photos", 5), proofController.submitProof);
router.get("/:id", authMiddleware, proofController.getProof);
router.get("/user/:userId", authMiddleware, proofController.getUserProofs);

export default router;
