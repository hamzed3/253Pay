.PHONY: help setup install dev dev-backend dev-mobile stop restart logs clean

help:
	@echo "253Pay - Makefile Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make setup         - Setup complet du projet"
	@echo "  make install       - Installer les dépendances"
	@echo ""
	@echo "Développement:"
	@echo "  make dev           - Lancer backend + base de données"
	@echo "  make dev-backend   - Lancer seulement le backend"
	@echo "  make dev-mobile    - Lancer l'app mobile"
	@echo ""
	@echo "Docker:"
	@echo "  make up            - Démarrer les services"
	@echo "  make down          - Arrêter les services"
	@echo "  make logs          - Voir les logs"
	@echo "  make clean         - Nettoyer les volumes"

setup:
	@echo "🚀 Setup 253Pay..."
	cp .env.example .env
	cd backend && npm install
	cd mobile && flutter pub get
	@echo "✅ Setup terminé!"

install:
	@echo "📦 Installation des dépendances..."
	cd backend && npm install
	cd mobile && flutter pub get

up:
	@echo "🐳 Démarrage des services Docker..."
	docker-compose up -d
	@echo "✅ Services démarrés"

down:
	@echo "🛑 Arrêt des services Docker..."
	docker-compose down

dev: up
	@echo "🚀 Démarrage du backend..."
	cd backend && npm run dev

dev-backend:
	@echo "🚀 Démarrage du backend (sans Docker)..."
	cd backend && npm run dev

dev-mobile:
	@echo "📱 Démarrage de l'app mobile..."
	cd mobile && flutter run

logs:
	docker-compose logs -f

clean:
	@echo "🧹 Nettoyage..."
	docker-compose down -v
	rm -rf backend/node_modules
	rm -rf backend/dist
	rm -rf mobile/.dart_tool
	rm -rf mobile/build
	@echo "✅ Nettoyage terminé"

test-backend:
	@echo "🧪 Tests backend..."
	cd backend && npm test

test-mobile:
	@echo "🧪 Tests mobile..."
	cd mobile && flutter test
