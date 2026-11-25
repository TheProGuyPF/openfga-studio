import { OpenFGAService } from '../../services/OpenFGAService';
import type { Tuple } from '../../utils/migrationTransform';

/** Every tuple on `object`, following read pagination (errors propagate). */
export async function readAllOnObject(storeId: string, object: string): Promise<Tuple[]> {
  const out: Tuple[] = [];
  let token: string | undefined;
  do {
    const page = await OpenFGAService.readFiltered(storeId, {
      object,
      page_size: 100,
      continuation_token: token,
    });
    out.push(...page.tuples);
    token = page.continuation_token || undefined;
  } while (token);
  return out;
}
