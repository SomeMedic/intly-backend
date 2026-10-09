import { Injectable } from '@nestjs/common';

import { Opportunity, SourceOccurrence } from '../opportunities/schemas/opportunity.schema';
import { Profile, MatchWeights, DEFAULT_MATCH_WEIGHTS } from '../profiles/schemas/profile.schema';

export type MatchComponents = {
  skills: number;
  seniority: number;
  money: number;
  remoteLocation: number;
  employment: number;
  freshness: number;
  source: number;
};

export type MatchResult = {
  score: number;
  components: MatchComponents;
  matchedSkills: string[];
  explanation: string[];
};

export type MatchingOpportunity = Pick<Opportunity,
  'skills' | 'technologies' | 'seniority' | 'money' | 'remoteType' | 'location' |
  'employmentType' | 'publishedAt' | 'firstSeenAt'
> & { sourceOccurrences: Array<Pick<SourceOccurrence, 'sourceId'>> };

@Injectable()
export class MatchingService {
  calculate(opportunity: MatchingOpportunity, profile: Profile): MatchResult {
    const components: MatchComponents = {
      skills: this.scoreSkills(opportunity, profile),
      seniority: this.scoreSet(opportunity.seniority ? [opportunity.seniority] : [], profile.seniority ?? []),
      money: this.scoreMoney(opportunity.money, profile.compensationPreferences ?? {}),
      remoteLocation: this.scoreRemoteLocation(opportunity, profile),
      employment: this.scoreSet(opportunity.employmentType ? [opportunity.employmentType] : [], profile.employmentTypes ?? []),
      freshness: this.scoreFreshness(opportunity.publishedAt ?? opportunity.firstSeenAt),
      source: this.scoreSet(
        opportunity.sourceOccurrences.map((occurrence) => occurrence.sourceId),
        profile.sourceIds ?? [],
      ),
    };

    const weights = this.normalizeWeights(profile.matchWeights);
    const weighted = Object.entries(components).reduce((total, [key, value]) => {
      return total + value * weights[key as keyof MatchWeights];
    }, 0);
    const score = Math.round(weighted / 100);
    const matchedSkills = this.intersection(
      [...(opportunity.skills ?? []), ...(opportunity.technologies ?? [])],
      profile.technologies ?? [],
    );

    return {
      score,
      components,
      matchedSkills,
      explanation: this.explain(components, matchedSkills),
    };
  }

  private scoreSkills(opportunity: MatchingOpportunity, profile: Profile): number {
    const candidateTerms = this.uniqueTerms([...(opportunity.skills ?? []), ...(opportunity.technologies ?? [])]);
    const targetTerms = this.uniqueTerms(profile.technologies ?? []);
    if (candidateTerms.length === 0 || targetTerms.length === 0) {
      return 50;
    }
    return Math.round((this.intersection(candidateTerms, targetTerms).length / targetTerms.length) * 100);
  }

  private scoreRemoteLocation(opportunity: MatchingOpportunity, profile: Profile): number {
    const preferences = profile.remotePreferences ?? [];
    const locations = profile.locations ?? [];
    if (preferences.length === 0 && locations.length === 0) {
      return 50;
    }
    const remoteScore = opportunity.remoteType ? this.scoreSet([opportunity.remoteType], preferences) : 50;
    const locationScore = opportunity.location ? this.scoreSet([opportunity.location], locations) : 50;
    return Math.round((remoteScore + locationScore) / 2);
  }

  private scoreMoney(money: Opportunity['money'], preferences: Record<string, unknown>): number {
    const minExpected = this.numberPreference(preferences, 'min');
    if (!minExpected || (!money?.min && !money?.max)) {
      return 50;
    }
    const offered = money?.max ?? money?.min ?? 0;
    if (offered >= minExpected) {
      return 100;
    }
    return Math.max(0, Math.round((offered / minExpected) * 100));
  }

  private scoreFreshness(date?: Date): number {
    if (!date) {
      return 50;
    }
    const days = (Date.now() - new Date(date).getTime()) / 86_400_000;
    if (days <= 3) return 100;
    if (days <= 14) return 75;
    if (days <= 30) return 50;
    return 25;
  }

  private scoreSet(values: string[], preferred: string[]): number {
    if (preferred.length === 0 || values.length === 0) {
      return 50;
    }
    return this.intersection(values, preferred).length > 0 ? 100 : 0;
  }

  private normalizeWeights(weights?: MatchWeights): MatchWeights {
    const merged = { ...DEFAULT_MATCH_WEIGHTS, ...(weights ?? {}) };
    const total = Object.values(merged).reduce((sum, value) => sum + Math.max(0, value), 0) || 100;
    return Object.fromEntries(
      Object.entries(merged).map(([key, value]) => [key, (Math.max(0, value) / total) * 100]),
    ) as MatchWeights;
  }

  private intersection(left: string[], right: string[]): string[] {
    const rightSet = new Set(right.map((value) => value.toLowerCase().trim()).filter(Boolean));
    return this.uniqueTerms(left).filter((value) => rightSet.has(value.toLowerCase().trim()));
  }

  private uniqueTerms(values: string[]): string[] {
    const seen = new Set<string>();
    return values.flatMap((value) => {
      const term = value.trim();
      const key = term.toLowerCase();
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [term];
    });
  }

  private numberPreference(preferences: Record<string, unknown>, key: string): number | null {
    const value = preferences[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private explain(components: MatchComponents, matchedSkills: string[]): string[] {
    const explanation = [`Matched skills: ${matchedSkills.length}`];
    for (const [key, value] of Object.entries(components)) {
      explanation.push(`${key}: ${value}`);
    }
    return explanation;
  }
}
