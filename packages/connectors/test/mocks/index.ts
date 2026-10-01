// Provider mocks for connector tests and G1 (connector-interface.md §4): @wizard/connectors/mocks.
export { type ReceivedMail, SmtpMock, type SmtpMockOptions, type TestCert, testCert } from "./smtp/server.js";
export { type BotCall, type ScriptedReply, TelegramMock } from "./telegram/server.js";
export {
  type MockCard,
  type MockPayment,
  type MockPaymentMethod,
  type MockRefund,
  type ScriptedFailure,
  type YookassaCall,
  YookassaMock,
} from "./yookassa/server.js";
