import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../database/redis.service';

/**
 * GET /health
 *
 * Ce point d'entrée ne dit pas seulement « le serveur répond ». Il vérifie
 * réellement PostgreSQL et Redis. Un serveur qui répond « ok » alors que sa
 * base est tombée est plus dangereux qu'un serveur éteint : il laisse croire
 * que tout va bien.
 */
@ApiTags('health')
@Controller('health')
@SkipThrottle()
// Le JwtAuthGuard est global : sans @Public, l'orchestrateur (Docker,
// Kubernetes) recevrait un 401 et croirait le service en panne.
@Public()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @ApiOperation({ summary: "État de l'API et de ses dépendances" })
  async check() {
    const [dbUp, redisUp] = await Promise.all([this.prisma.ping(), this.redis.ping()]);

    const payload = {
      status: dbUp && redisUp ? 'ok' : 'degraded',
      db: dbUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
      version: process.env.npm_package_version ?? '0.1.0',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    // 503 si une dépendance est tombée : c'est ce que lira l'orchestrateur.
    if (!dbUp || !redisUp) throw new ServiceUnavailableException(payload);
    return payload;
  }
}
