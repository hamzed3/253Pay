import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

export class QuoteWithdrawalDto {
  @ApiProperty({ example: '10000', description: 'Montant à recevoir, en FDJ' })
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'Montant invalide : chiffres attendus, au maximum 2 décimales.',
  })
  amount!: string;
}

export class CreateWithdrawalDto extends QuoteWithdrawalDto {
  @ApiProperty({ example: '77123456', description: 'Compte chez le partenaire' })
  @IsNotEmpty()
  @MaxLength(64)
  account!: string;

  @ApiProperty({ example: '7391', description: 'Code secret : de l’argent sort du compte' })
  @IsNumberString()
  @Length(4, 6)
  pin!: string;

  @ApiPropertyOptional({ example: 'MOCK' })
  @IsOptional()
  @IsIn(['MOCK'])
  provider?: string;
}
