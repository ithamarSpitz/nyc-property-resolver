import { rowsUpdatedAtToDate } from '../../../src/services/ecb/ingestion-initialization.service';

export const START_WATERMARK_SECONDS = 1_726_000_000;
export const START_WATERMARK = rowsUpdatedAtToDate(START_WATERMARK_SECONDS);
