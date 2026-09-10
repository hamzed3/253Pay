import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class StatementQueryDto {
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Plafonné : sans limite, une requête ramènerait tout l'historique d'un
  // compte et mettrait la base à genoux.
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ description: 'Identifiant de la dernière ligne reçue' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}
