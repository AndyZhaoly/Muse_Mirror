import type {
  MirrorGarmentOwnership,
  MirrorGarmentPresentation,
  MirrorSituationObservation,
} from './mirrorSituation.js';

export type OutfitEpisodeStatus = 'observing' | 'stable' | 'ended' | 'cancelled';

export interface OutfitEpisode {
  episodeId: string;
  status: OutfitEpisodeStatus;
  startedAt: string;
  endedAt?: string;
  observationIds: string[];
  latestObservationId?: string;
  consecutiveReliableObservations: number;
  latestGarmentPresentation: MirrorGarmentPresentation;
  ownership: MirrorGarmentOwnership;
  ownershipQuestion: 'not_asked' | 'asked' | 'answered';
}

export type OutfitEpisodeEvent =
  | {
      type: 'observation_received';
      observation: MirrorSituationObservation;
    }
  | {
      type: 'ownership_question_asked';
      occurredAt: string;
    }
  | {
      type: 'ownership_confirmed';
      ownership: Exclude<MirrorGarmentOwnership, 'unknown'>;
      occurredAt: string;
    }
  | {
      type: 'episode_ended';
      occurredAt: string;
    }
  | {
      type: 'episode_cancelled';
      occurredAt: string;
    };

export function createOutfitEpisode(input: {
  episodeId: string;
  startedAt: string;
}): OutfitEpisode {
  return {
    episodeId: input.episodeId,
    status: 'observing',
    startedAt: input.startedAt,
    observationIds: [],
    consecutiveReliableObservations: 0,
    latestGarmentPresentation: 'none',
    ownership: 'unknown',
    ownershipQuestion: 'not_asked',
  };
}

export function reduceOutfitEpisode(
  episode: OutfitEpisode,
  event: OutfitEpisodeEvent,
): OutfitEpisode {
  if (episode.status === 'ended' || episode.status === 'cancelled') return episode;

  if (event.type === 'episode_ended' || event.type === 'episode_cancelled') {
    return {
      ...episode,
      status: event.type === 'episode_ended' ? 'ended' : 'cancelled',
      endedAt: event.occurredAt,
    };
  }

  if (event.type === 'ownership_question_asked') {
    return {
      ...episode,
      ownershipQuestion: episode.ownershipQuestion === 'answered' ? 'answered' : 'asked',
    };
  }

  if (event.type === 'ownership_confirmed') {
    return {
      ...episode,
      ownership: event.ownership,
      ownershipQuestion: 'answered',
    };
  }

  const observation = event.observation;
  const reliable = isReliableObservation(observation);
  const sameSignal =
    episode.latestObservationId !== undefined &&
    episode.latestGarmentPresentation === observation.garmentPresentation;
  const consecutiveReliableObservations = reliable
    ? sameSignal
      ? episode.consecutiveReliableObservations + 1
      : 1
    : 0;

  return {
    ...episode,
    status: consecutiveReliableObservations >= 2 ? 'stable' : 'observing',
    observationIds: [...episode.observationIds, observation.observationId],
    latestObservationId: observation.observationId,
    consecutiveReliableObservations,
    latestGarmentPresentation: observation.garmentPresentation,
    ownership: observation.ownership === 'unknown' ? episode.ownership : observation.ownership,
  };
}

export function reduceOutfitEpisodeEvents(
  episode: OutfitEpisode,
  events: readonly OutfitEpisodeEvent[],
): OutfitEpisode {
  return events.reduce(reduceOutfitEpisode, episode);
}

function isReliableObservation(observation: MirrorSituationObservation): boolean {
  return (
    observation.freshness === 'fresh' &&
    observation.quality === 'good' &&
    observation.motion === 'still' &&
    observation.personCount === 1 &&
    observation.identity === 'known_user' &&
    observation.privacyRisk === 'none' &&
    observation.garmentPresentation !== 'none' &&
    observation.garmentPresentation !== 'unknown'
  );
}
