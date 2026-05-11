import { useQuery } from "@tanstack/react-query";
import { companyBrainApi } from "../../../lib/api";
import { brainKeys } from "./keys";

export function useBrainFiles() {
  return useQuery({
    queryKey: brainKeys.list(),
    queryFn: async () => {
      const { files } = await companyBrainApi.list();
      return files;
    },
    refetchOnWindowFocus: false,
  });
}
