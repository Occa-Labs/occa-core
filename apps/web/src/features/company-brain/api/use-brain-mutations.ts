import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  companyBrainApi,
  type CreateBrainFileRequest,
  type UpdateBrainFileRequest,
} from "../../../lib/api";
import { brainKeys } from "./keys";

export function useCreateBrainFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateBrainFileRequest) => {
      const { file } = await companyBrainApi.create(input);
      return file;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: brainKeys.list() });
    },
  });
}

export function useUpdateBrainFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; updates: UpdateBrainFileRequest }) => {
      const { file } = await companyBrainApi.update(args.id, args.updates);
      return file;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: brainKeys.list() });
    },
  });
}

export function useDeleteBrainFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await companyBrainApi.remove(id);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: brainKeys.list() });
    },
  });
}
