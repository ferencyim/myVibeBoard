import AsyncStorage from "@react-native-async-storage/async-storage";
import { BranchSuggestionsResponseSchema } from "@getpaseo/protocol/messages";
import { readValidatedJson } from "@/storage/validated-storage";

const schema = BranchSuggestionsResponseSchema.shape.payload;
type BranchSuggestions = import("@getpaseo/protocol/messages").BranchSuggestionsResponse["payload"];
const key = (serverId: string, cwd: string) =>
  "@paseo/branch-suggestions/v1:" + JSON.stringify([serverId, cwd]);

export async function readCachedBranchSuggestions(
  serverId: string,
  cwd: string,
  query: string,
): Promise<BranchSuggestions | null> {
  const cached = await readValidatedJson(AsyncStorage, key(serverId, cwd), schema);
  if (!cached) return null;
  const search = query.trim().toLocaleLowerCase();
  return {
    ...cached,
    branches: cached.branches.filter((name) => name.toLocaleLowerCase().includes(search)),
    branchDetails: cached.branchDetails?.filter((branch) =>
      branch.name.toLocaleLowerCase().includes(search),
    ),
  };
}

export async function cacheBranchSuggestions(
  serverId: string,
  cwd: string,
  result: BranchSuggestions,
): Promise<void> {
  if (result.error) return;
  await AsyncStorage.setItem(key(serverId, cwd), JSON.stringify(result));
}
