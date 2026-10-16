/* Seeds both fictional personas into FalkorDB. Run: npm run seed */
import { seed } from "../src/lib/seed";

seed()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
