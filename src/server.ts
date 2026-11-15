import { app } from './app';
import { config } from './config/env';
import { startReconciler } from './modules/kyc/reconcile';

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
  startReconciler();
});