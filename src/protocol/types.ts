export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TurnRequest {
  request_id: string;
  conversation_id: string;
  message: string;
  history: HistoryMessage[];
}
