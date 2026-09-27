import { WorkAdmissionPool } from "./work-admission.js";

/**
 * The backend's single `git-docker-scan` admission pool (4 concurrent, 1 per
 * target by default; see `DEFAULT_ADMISSION_POOL_LIMITS`).
 *
 * Every owner of Git/Docker status work shares this one instance, so the
 * global bound holds across owners: worktree snapshot scans and tree walks
 * (`DiffStatsService`) today; later owners of the same resource class must
 * acquire here rather than construct their own pool.
 */
export const gitDockerScanPool = new WorkAdmissionPool({ name: "git-docker-scan" });
