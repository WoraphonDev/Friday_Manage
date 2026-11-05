import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';

/** ล็อกอิน, Session, 2FA, OAuth, API token · งาน: A13, A28 */
@Module({
  controllers: [AuthController],
  providers: [],
})
export class AuthModule {}
