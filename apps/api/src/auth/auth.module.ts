import { Module } from '@nestjs/common';
import { AccountService } from './account.service.js';
import { ApiTokensController } from './api-tokens.controller.js';
import { ApiTokensService } from './api-tokens.service.js';
import { AuthController } from './auth.controller.js';
import { AuthTokenService } from './auth-tokens.js';
import { LoginService } from './login.service.js';
import { MeSecurityController } from './me-security.controller.js';
import { MfaService } from './mfa.service.js';
import { OAuthController } from './oauth.controller.js';
import { SecurityService } from './security.service.js';

/** ล็อกอิน, Session, 2FA, OAuth, API token · งาน: A13, A28 */
@Module({
  controllers: [AuthController, OAuthController, MeSecurityController, ApiTokensController],
  providers: [ApiTokensService, AccountService, AuthTokenService, LoginService, MfaService, SecurityService],
})
export class AuthModule {}
