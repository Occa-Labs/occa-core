import { useQuery } from "@tanstack/react-query";
import { documentsApi } from "../../../lib/api";
import { documentKeys } from "./keys";

export function useDocumentsList(opts: { tags?: string[]; limit?: number }) {
  return useQuery({
    queryKey: documentKeys.list(opts),
    queryFn: async () => {
      const { documents } = await documentsApi.list(opts);
      return documents;
    },
    refetchOnWindowFocus: false,
  });
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: id ? documentKeys.detail(id) : ["documents", "detail", "none"],
    queryFn: async () => {
      if (!id) return null;
      const { document } = await documentsApi.get(id);
      return document;
    },
    enabled: id !== null,
    refetchOnWindowFocus: false,
  });
}
