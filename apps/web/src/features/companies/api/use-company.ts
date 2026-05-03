"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  CompanyDTO,
  CompanyStats,
  PauseCompanyRequest,
  UpdateCompanyRequest,
} from "@occa/shared/types";
import { ApiError, companiesApi } from "@/lib/api";

export interface UseCompanyResult {
  company: CompanyDTO | null;
  stats: CompanyStats | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  update: (input: UpdateCompanyRequest) => Promise<CompanyDTO>;
  pause: (reason?: string | null) => Promise<CompanyDTO>;
  resume: () => Promise<CompanyDTO>;
}

/**
 * Single-source-of-truth hook for the active user company. Exposes the
 * mutation calls used by the Company window so we don't have to thread
 * api refs everywhere.
 */
export function useCompany(companyId: string | null): UseCompanyResult {
  const [company, setCompany] = useState<CompanyDTO | null>(null);
  const [stats, setStats] = useState<CompanyStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!companyId) {
      setCompany(null);
      setStats(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await companiesApi.get(companyId);
      setCompany(res.company);
      setStats(res.stats);
    } catch (err) {
      const message =
        err instanceof ApiError ? `api_${err.status}` : "network_error";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (input: UpdateCompanyRequest): Promise<CompanyDTO> => {
      if (!companyId) throw new Error("no_company");
      const res = await companiesApi.update(companyId, input);
      setCompany(res.company);
      setStats(res.stats);
      return res.company;
    },
    [companyId],
  );

  const pause = useCallback(
    async (reason?: string | null): Promise<CompanyDTO> => {
      if (!companyId) throw new Error("no_company");
      const body: PauseCompanyRequest = reason ? { reason } : {};
      const res = await companiesApi.pause(companyId, body);
      setCompany(res.company);
      setStats(res.stats);
      return res.company;
    },
    [companyId],
  );

  const resume = useCallback(async (): Promise<CompanyDTO> => {
    if (!companyId) throw new Error("no_company");
    const res = await companiesApi.resume(companyId);
    setCompany(res.company);
    setStats(res.stats);
    return res.company;
  }, [companyId]);

  return { company, stats, loading, error, refresh, update, pause, resume };
}
