// Worker registry wiring — one Worker per TaskType.
import { registerWorker } from './registry';
import { discoveryWorker } from './discovery';
import { scoreWorker } from './score';
import { tailorWorker } from './tailor';
import { applyWorker } from './apply';
import { emailScanWorker } from './email-scan';
import { emailSendWorker } from './email-send';
import { followupWorker } from './followup';
import { prepGuideWorker } from './prep-guide';
import { profileSyncWorker } from './profile-sync';
import { askWorker } from './ask';
import { feedbackWorker } from './feedback';
import { setupWorker } from './setup';
import { regenQueriesWorker } from './regen-queries';

export function registerAllWorkers(): void {
  registerWorker(discoveryWorker);
  registerWorker(scoreWorker);
  registerWorker(tailorWorker);
  registerWorker(applyWorker);
  registerWorker(emailScanWorker);
  registerWorker(emailSendWorker);
  registerWorker(followupWorker);
  registerWorker(prepGuideWorker);
  registerWorker(profileSyncWorker);
  registerWorker(askWorker);
  registerWorker(feedbackWorker);
  registerWorker(setupWorker);
  registerWorker(regenQueriesWorker);
}

export { PauseRequested, NeedsHuman, WaitingSession } from './registry';
