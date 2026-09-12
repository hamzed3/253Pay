import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DevicePlatform, OtpPurpose } from '@prisma/client';

/**
 * Toute entrée d'API passe par un DTO.
 *
 * Rappel de main.ts : la validation est en mode `forbidNonWhitelisted`. Un
 * champ non déclaré ici fait ÉCHOUER la requête. Sur une API financière, un
 * champ inattendu est presque toujours une tentative d'abus — par exemple
 * l'envoi d'un `role` ou d'un `kycLevel` que le client n'a pas à décider.
 */

export class DeviceDto {
  @ApiProperty({ example: 'a3f1c9d2-7b8e-4a1f-9c2d-5e6f7a8b9c0d' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  deviceId!: string;

  @ApiProperty({ enum: DevicePlatform, example: 'ANDROID' })
  @IsEnum(DevicePlatform)
  platform!: DevicePlatform;

  @ApiPropertyOptional({ example: 'Samsung A14' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;
}

export class RequestOtpDto {
  @ApiProperty({ example: '77123456', description: 'Numéro djiboutien, avec ou sans +253' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ enum: OtpPurpose, example: 'REGISTRATION' })
  @IsEnum(OtpPurpose)
  purpose!: OtpPurpose;
}

export class RegisterDto {
  @ApiProperty({ example: '77123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ example: '482913', description: 'Code reçu par SMS' })
  @IsNumberString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ example: 'Hamze' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Moussa' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName!: string;

  @ApiProperty({ example: '7391', description: 'Code secret à 4 chiffres' })
  @IsNumberString()
  @Length(4, 6)
  pin!: string;

  @ApiProperty({ type: DeviceDto })
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class LoginDto {
  @ApiProperty({ example: '77123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ example: '7391' })
  @IsNumberString()
  @Length(4, 6)
  pin!: string;

  @ApiProperty({ type: DeviceDto })
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class VerifyLoginOtpDto {
  @ApiProperty({ example: '77123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ example: '482913' })
  @IsNumberString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ type: DeviceDto })
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class RefreshDto {
  @ApiProperty({ description: 'Jeton de renouvellement obtenu à la connexion' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken!: string;
}

export class ChangePinDto {
  @ApiProperty({ example: '7391' })
  @IsNumberString()
  @Length(4, 6)
  currentPin!: string;

  @ApiProperty({ example: '5286' })
  @IsNumberString()
  @Length(4, 6)
  newPin!: string;
}

export class ResetPinDto {
  @ApiProperty({ example: '77123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phone!: string;

  @ApiProperty({ example: '482913' })
  @IsNumberString()
  @Length(4, 8)
  code!: string;

  @ApiProperty({ example: '5286' })
  @IsNumberString()
  @Length(4, 6)
  newPin!: string;
}
