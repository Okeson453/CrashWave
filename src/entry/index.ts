/**
 * Personal-Use Entry Dispatcher
 *
 * The single-process personal-use build has only one process role: `monolith`.
 * This file is the 3-line wrapper that `src/index.ts` calls. It exists so
 * that the spec §5.8 "two entry files" layout (dispatcher + monolith) is
 * preserved even though both ultimately call the same function.
 */
import { main } from './monolith';

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error in monolith.main():', err);
  process.exit(1);
});
